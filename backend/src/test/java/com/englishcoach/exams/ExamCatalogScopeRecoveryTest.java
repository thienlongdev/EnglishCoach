package com.englishcoach.exams;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.model.ExamContentRecords.CatalogFormDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.*;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.transaction.PlatformTransactionManager;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ExamCatalogScopeRecoveryTest {
    @Test void scopeSummaryReusesCachedTreeAndChecksRights() throws Exception {
        var mapper = new ObjectMapper().findAndRegisterModules();
        var pkg = mapper.readValue(Path.of("../content/exams/original-pilot/IELTS/IELTS_GT_WRITING_PILOT_001_V1.json").toFile(), ExamContentPackage.class);
        var repository = mock(ExamContentRepository.class);
        var trees = mock(ExamContentValidationRepository.class);
        var rights = mock(ExamRightsService.class);
        UUID id = pkg.form().id();
        var canonical = ExamContentTree.fromPackage(pkg, mapper);
        when(trees.loadTrees(List.of(id))).thenReturn(Map.of(id, canonical));
        when(trees.catalogInputs(anyCollection())).thenReturn(Map.of(id, new ExamContentValidationRepository.CatalogInput("revision", null)));
        var validation = new ExamContentValidationService(trees, mapper,
                new StaticListableBeanFactory().getBeanProvider(PlatformTransactionManager.class));
        var service = new ExamContentService(repository, new ExamsProperties(), validation, rights);
        when(repository.findPublishedCatalogForms(ExamFamily.IELTS, null, null, 50, 0, true)).thenReturn(List.of(
                new CatalogFormDto(id, "fixture", 1, "fixture", ExamFamily.IELTS, "GENERAL_TRAINING", "WRITING",
                        "fixture", 60, 2, List.of("WRITING"), LifecycleState.PILOT, null)));
        when(rights.verifyFormRightsBatch(List.of(id))).thenReturn(Map.of(id, true));
        assertEquals(List.of("IELTS_WRITING_TASK_1", "IELTS_WRITING_TASK_2"),
                service.getCatalog(ExamFamily.IELTS, null, null, 50, 0, true).getFirst().practiceScopeCodes());
        when(rights.verifyFormRightsBatch(List.of(id))).thenReturn(Map.of(id, false));
        assertTrue(service.getCatalog(ExamFamily.IELTS, null, null, 50, 0, true).getFirst().practiceScopeCodes().isEmpty());
        verify(trees, times(1)).loadTrees(List.of(id));
    }
    @Test void filteredWindowsRemainDeterministicAndContainOnlyMetadata() throws Exception {
        var mapper = new ObjectMapper().findAndRegisterModules();
        var pkg = mapper.readValue(Path.of("../content/exams/original-pilot/IELTS/IELTS_GT_WRITING_PILOT_001_V1.json").toFile(), ExamContentPackage.class);
        var tree = ExamContentTree.fromPackage(pkg, mapper);
        var report = ExamFormValidator.validate(tree, mapper, java.time.Instant.now());
        var scopes = com.englishcoach.exams.practice.ExamPracticeReadiness.evaluate(tree, report,
                com.englishcoach.exams.release.ExamRunnerCapabilities.CURRENT,
                new com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts(true,true), mapper);
        var repo = mock(ExamContentRepository.class);
        var validation = mock(ExamContentValidationService.class);
        var rights = mock(ExamRightsService.class);
        var rows = new ArrayList<CatalogFormDto>();
        var grants = new HashMap<UUID,Boolean>();
        for (int i=0;i<60;i++) {
            UUID id=UUID.randomUUID(); grants.put(id,i<30);
            rows.add(new CatalogFormDto(id,"test_"+i,1,"Test "+i,ExamFamily.IELTS,"GENERAL_TRAINING","WRITING",
                    "Collection",60,2,List.of("WRITING"),LifecycleState.PILOT,null));
            when(validation.evaluate(id)).thenReturn(report);
            when(validation.practiceScopes(eq(id),any())).thenAnswer(inv ->
                ((com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts) inv.getArgument(1)).rightsVerified() ? scopes : List.of());
        }
        when(validation.catalogSummaries(anyCollection())).thenAnswer(inv -> {
            Map<UUID, ExamCatalogStructuralSummary> summaries = new HashMap<>();
            for (UUID id : (Collection<UUID>) inv.getArgument(0)) summaries.put(id, new ExamCatalogStructuralSummary(id, "revision", report.contentFingerprint(), report.validatorVersion(), "readiness",
                ExamFormValidationReport.skillNames(report.practiceSkills()), ExamFormValidationReport.skillNames(report.simulationSkills()), report.fullSimulationEligible(), report.contentReviewRequired(), report.availableModes(), report.status().name(),
                scopes.stream().filter(com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness::ready).map(v -> v.scope().scopeCode()).toList()));
            return summaries;
        });
        when(repo.findPublishedCatalogForms(ExamFamily.IELTS,null,null,128,0,true)).thenReturn(rows);
        when(rights.verifyFormRightsBatch(anyCollection())).thenReturn(grants);
        var service=new ExamContentService(repo,new ExamsProperties(),validation,rights);
        var first=service.getCatalogWindow(ExamFamily.IELTS,null,null,24,0,true,"PRACTICE","",null);
        var second=service.getCatalogWindow(ExamFamily.IELTS,null,null,24,24,true,"PRACTICE","",null);
        assertEquals(24,first.forms().size()); assertEquals(6,second.forms().size());
        assertEquals(30,first.total()); assertTrue(first.hasMore()); assertFalse(second.hasMore());
        assertEquals(first,service.getCatalogWindow(ExamFamily.IELTS,null,null,24,0,true,"PRACTICE","",null));
        assertTrue(first.forms().stream().allMatch(f->!f.practiceScopeCodes().isEmpty()));
        assertEquals(60,service.getCatalogWindow(ExamFamily.IELTS,null,null,24,0,true,"ALL","",null).total());
        assertEquals(1,service.getCatalogWindow(ExamFamily.IELTS,null,null,24,0,true,"ALL","Test 59",null).total());
        var json=mapper.writeValueAsString(first);
        for(String forbidden:List.of("acceptedAnswers","answerSpecs","bodyPayload","transcript","diagnostics","ownerUserId","attemptId")) assertFalse(json.contains(forbidden));
    }

}
