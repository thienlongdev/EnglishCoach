package com.englishcoach.exams.release;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.practice.*;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ExamScopedQaReadinessTest {
    final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();
    ExamContentPackage source() throws Exception {
        return mapper.readValue(Path.of("../imports/exams/staging/extracted/ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json").toFile(), ExamContentPackage.class);
    }
    ExamScopedQaReadiness.Result evaluate(ExamContentPackage pkg, Map<String,Object> entry) {
        var tree = ExamContentTree.fromPackage(pkg, mapper);
        var report = ExamFormValidator.validate(tree, mapper, Instant.now());
        var scopes = ExamPracticeReadiness.evaluate(tree, report, ExamRunnerCapabilities.CURRENT,
                new ExamPracticeReadiness.FormFacts(true, true), mapper);
        return ExamScopedQaReadiness.evaluate(pkg, tree, scopes, true, List.of(entry), mapper);
    }
    Map<String,Object> entry(ExamContentPackage pkg) {
        return new HashMap<>(Map.of("id", "synthetic", "packageId", pkg.manifest().packageId(),
                "packageContentHash", pkg.manifest().contentHash(), "releasePriority", "P0", "status", "OPEN"));
    }
    @Test void commaListsAndRangesAreCompleteAndBounded() {
        assertEquals(Set.of(9,38), ExamScopedQaReadiness.questionNumbers("9,38"));
        assertEquals(Set.of(1,2,3,7), ExamScopedQaReadiness.questionNumbers("1-3;7"));
        assertEquals(Set.of(19,20), ExamScopedQaReadiness.questionNumbers("19&20"));
        for (String bad : List.of("9,", "9,unknown", "40-9", "1-999", "0", "19&&20", "19&unknown"))
            assertNull(ExamScopedQaReadiness.questionNumbers(bad));
    }
    @Test void knownWritingQaDoesNotBlockIndependentReadingOrListening() throws Exception {
        var pkg=source(); var entry=entry(pkg); entry.put("scope", "WRITING/TASK_1");
        var result=evaluate(pkg,entry);
        assertFalse(result.scopes().get("IELTS_WRITING_TASK_1").ready());
        assertTrue(result.scopes().get("IELTS_READING_PASSAGE_1").ready());
        assertTrue(result.scopes().get("IELTS_LISTENING_SECTION_1").ready());
        assertTrue(result.unresolvedEntryIds().isEmpty());
    }
    @Test void commaSeparatedQuestionQaMapsEveryAffectedPassage() throws Exception {
        var pkg=source(); var entry=entry(pkg); entry.put("scope","ANSWER_KEY/READING"); entry.put("questions","9,38");
        var result=evaluate(pkg,entry);
        assertFalse(result.scopes().get("IELTS_READING_PASSAGE_1").ready());
        assertFalse(result.scopes().get("IELTS_READING_PASSAGE_3").ready());
        assertTrue(result.scopes().get("IELTS_READING_PASSAGE_2").ready());
    }
    @Test void printedPairKeyQaAffectsOnlyItsListeningSection() throws Exception {
        var pkg=source(); var entry=entry(pkg);entry.put("scope","ANSWER_KEY/LISTENING");entry.put("questions","19&20");
        var result=evaluate(pkg,entry);
        assertFalse(result.scopes().get("IELTS_LISTENING_SECTION_2").ready());
        assertTrue(result.scopes().get("IELTS_LISTENING_SECTION_3").ready());
        assertTrue(result.scopes().get("IELTS_READING_PASSAGE_1").ready());
        assertTrue(result.unresolvedEntryIds().isEmpty());
    }
    @Test void absentSkillKeyQaCannotBlockRetainedReadingButStaleEntryStillDoes() throws Exception {
        var pkg=source();var tree=ExamContentTree.fromPackage(pkg,mapper);
        var readingOnly=new ExamContentTree(tree.formId(),tree.family(),tree.variant(),tree.scope(),tree.operatorHealth(),
                tree.scoringSchemePresent(),tree.declaredBlueprint(),tree.sections().stream().filter(s->s.skill().name().equals("READING")).toList());
        var report=ExamFormValidator.validate(readingOnly,mapper,Instant.now());
        var scopes=ExamPracticeReadiness.evaluate(readingOnly,report,ExamRunnerCapabilities.CURRENT,new ExamPracticeReadiness.FormFacts(true,true),mapper);
        var entry=entry(pkg);entry.put("scope","ANSWER_KEY/LISTENING");entry.put("questions","1-40");
        var result=ExamScopedQaReadiness.evaluate(pkg,readingOnly,scopes,true,List.of(entry),mapper);
        assertTrue(result.scopes().values().stream().allMatch(ExamScopedQaReadiness.ScopeQa::ready));
        assertEquals(List.of("synthetic"),result.unreferencedScopeEntryIds());
        entry.put("packageContentHash","0".repeat(64));
        assertTrue(ExamScopedQaReadiness.evaluate(pkg,readingOnly,scopes,true,List.of(entry),mapper).scopes().values().stream().noneMatch(ExamScopedQaReadiness.ScopeQa::ready));
    }
    @Test void staleAndUnknownAttributionFailClosed() throws Exception {
        var pkg=source(); var unknown=entry(pkg);
        assertTrue(evaluate(pkg,unknown).scopes().values().stream().noneMatch(ExamScopedQaReadiness.ScopeQa::ready));
        unknown.put("scope","WRITING/TASK_1"); unknown.put("packageContentHash","0".repeat(64));
        assertTrue(evaluate(pkg,unknown).scopes().values().stream().noneMatch(ExamScopedQaReadiness.ScopeQa::ready));
    }
    @Test void cropHashUsesCanonicalBinding() throws Exception {
        var pkg=source(); var entry=entry(pkg);
        entry.put("cropSha256",pkg.assets().stream().filter(a->a.mimeType().startsWith("image/")).findFirst().orElseThrow().sha256Hash());
        var result=evaluate(pkg,entry);
        assertFalse(result.scopes().get("IELTS_WRITING_TASK_1").ready());
        assertTrue(result.scopes().get("IELTS_READING_PASSAGE_1").ready());
        assertTrue(result.unresolvedEntryIds().isEmpty());
    }
    @Test void unplacedIntermediateCropHasNoLearnerDependencyButStaleCropStillBlocks() throws Exception {
        var pkg=source(); var entry=entry(pkg);
        entry.put("cropSha256", "0".repeat(64)); entry.put("subtype", "PAGE_REGION_RENDERING");
        var result=evaluate(pkg,entry);
        assertTrue(result.scopes().values().stream().allMatch(ExamScopedQaReadiness.ScopeQa::ready));
        assertEquals(List.of("synthetic"), result.unreferencedCropEntryIds());
        entry.put("packageContentHash", "1".repeat(64));
        assertTrue(evaluate(pkg,entry).scopes().values().stream().noneMatch(ExamScopedQaReadiness.ScopeQa::ready));
    }
    @Test void nestedPrintedQuestionScopeBlocksItsPartAndPreservesOtherParts() throws Exception {
        var pkg=mapper.readValue(Path.of("../imports/exams/staging/extracted/toeic/ets/ets-2026/ets-2026__test-1.json").toFile(), ExamContentPackage.class);
        var entry=entry(pkg); entry.put("scope", "READING/PART_7/Q181-185");
        var result=evaluate(pkg,entry);
        assertFalse(result.scopes().get("TOEIC_PART_7").ready());
        assertTrue(result.scopes().get("TOEIC_PART_2").ready());
        assertTrue(result.scopes().get("TOEIC_PART_5").ready());
        assertTrue(result.unresolvedEntryIds().isEmpty());
    }
    @Test void omittedPartQaHasNoRetainedDependencyAndNeverApprovesThatPart() throws Exception {
        var pkg=mapper.readValue(Path.of("../imports/exams/staging/extracted/toeic/ets/ets-2026/ets-2026__test-1.json").toFile(), ExamContentPackage.class);
        var tree=ExamContentTree.fromPackage(pkg,mapper);
        var withoutPart6=new ExamContentTree(tree.formId(),tree.family(),tree.variant(),tree.scope(),tree.operatorHealth(),
                tree.scoringSchemePresent(),tree.declaredBlueprint(),tree.sections().stream().map(s->new ExamContentTree.SectionNode(
                    s.id(),s.formId(),s.skill(),s.ordinal(),s.durationSeconds(),s.operatorEnabled(),s.operatorFormHealth(),
                    s.parts().stream().filter(p->!p.partCode().equals("READING_PART_6")).toList())).toList());
        var report=ExamFormValidator.validate(withoutPart6,mapper,Instant.now());
        var scopes=ExamPracticeReadiness.evaluate(withoutPart6,report,ExamRunnerCapabilities.CURRENT,
                new ExamPracticeReadiness.FormFacts(true,true),mapper);
        var entry=entry(pkg);entry.put("scope","READING/PART_6/Q143-146");entry.put("questions","146");
        var result=ExamScopedQaReadiness.evaluate(pkg,withoutPart6,scopes,true,List.of(entry),mapper);
        assertEquals(List.of("synthetic"),result.unreferencedScopeEntryIds());
        assertTrue(result.scopes().values().stream().allMatch(ExamScopedQaReadiness.ScopeQa::ready));
        assertFalse(result.scopes().containsKey("TOEIC_PART_6"));
        entry.put("packageContentHash","0".repeat(64));
        assertTrue(ExamScopedQaReadiness.evaluate(pkg,withoutPart6,scopes,true,List.of(entry),mapper).scopes().values()
                .stream().noneMatch(ExamScopedQaReadiness.ScopeQa::ready));
        entry.put("packageContentHash",pkg.manifest().contentHash());entry.put("questions","146,unknown");
        assertTrue(ExamScopedQaReadiness.evaluate(pkg,withoutPart6,scopes,true,List.of(entry),mapper).scopes().values()
                .stream().noneMatch(ExamScopedQaReadiness.ScopeQa::ready));
    }
}
