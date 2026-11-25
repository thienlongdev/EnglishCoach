package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.*;
import org.junit.jupiter.api.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import static com.englishcoach.exams.practice.ExamPracticePostgresTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** Seed the exact previous production batch, then qualify immutable successors and historical snapshots. */
class ExamCorpusPracticeSuccessorPostgresTest {
    @BeforeAll static void setup() throws Exception { ExamCorpusPracticeReleasePostgresTest.setup(); }
    @AfterAll static void close() { ExamCorpusPracticeReleasePostgresTest.close(); }
    @Test @SuppressWarnings("unchecked") void previousBatchUpgradesWithoutChangingOldAttempts() throws Exception {
        var importer=new ExamContentPackageImporter(contentRepository,new ExamContentPackageValidator(MAPPER)); importer.setValidationService(validation);
        var rights=new ExamRightsService(contentRepository,new ExamMediaRepository(named,MAPPER),new ExamsProperties());
        var publication=new ExamPublicationService(contentRepository,rights,null,validation);
        var state=new ExamImportStateJdbcReader(named,MAPPER); var executor=new ExamImportExecutor(importer,state,MAPPER);
        Path previous=Path.of(System.getProperty("exams.successor.previous-registry", "../docs/exams-production-verification/20261006/expansion-profiles-registry-before"));
        Map<String,Object> registry=MAPPER.readValue(previous.resolve("registry.json").toFile(),Map.class);
        Map<UUID,String> snapshots=new HashMap<>();
        for(var row:(List<Map<String,Object>>)registry.get("packages")) {
            var pkg=MAPPER.readValue(previous.resolve(String.valueOf(row.get("file"))).toFile(),ExamContentPackage.class);
            Set<String> scopes=new TreeSet<>((List<String>)row.get("scopeCodes"));
            var media=ExamMediaImportPlan.plan(pkg,Path.of(".."),true);
            var gate=ExamPracticeReleaseReadiness.evaluate(new ExamPracticePackageProjection.Result(pkg,scopes,Map.of()),media,MAPPER,Instant.now());
            var plan=ExamImportPlanner.planPractice(pkg,gate,media,List.of(),state,ExamImportPlanner.Target.PRODUCTION);
            var imported=executor.execute(plan,pkg,1L); publication.activateQualifiedPractice(imported.importedPackage(),scopes,1L,practice);
            UUID attempt=practice.createPracticeAttempt(LEARNER,new ExamPracticeRecords.CreatePracticeAttemptRequest(imported.result().formId(),scopes.iterator().next(),null)).attemptId();
            snapshots.put(attempt,jdbc.queryForObject("SELECT manifest_snapshot::text FROM exams.attempts WHERE id=?",String.class,attempt));
        }
        var service=new ExamCorpusPracticeReleaseService(MAPPER,named,importer,publication,practice,ExamCorpusPracticeReleasePostgresTest.storage);
        List<Map<String,Object>> receipts=service.releaseQualifiedBatch(1L);
        Map<String,Object> currentRegistry=MAPPER.readValue(Path.of("src/main/resources/exams/corpus-practice-release/registry.json").toFile(),Map.class);
        assertEquals(((List<?>)currentRegistry.get("packages")).size(),receipts.size());
        assertTrue(receipts.stream().anyMatch(r->"NEW_VERSION".equals(r.get("operation"))),"source repairs must create immutable successors");
        for(var entry:snapshots.entrySet()) assertEquals(entry.getValue(),jdbc.queryForObject("SELECT manifest_snapshot::text FROM exams.attempts WHERE id=?",String.class,entry.getKey()));
        assertTrue(service.releaseQualifiedBatch(1L).stream().allMatch(r->"ALREADY_IMPORTED".equals(r.get("operation"))));
        var catalog = contentRepository.findPublishedCatalogForms(null,null,null,1000,0,true);
        assertEquals(catalog.size(),catalog.stream().map(f->f.logicalKey()).distinct().count(),"superseded versions must not duplicate learner cards");
        for(var form:catalog) assertEquals(form.version(),jdbc.queryForObject(
                "SELECT max(version) FROM exams.form_versions WHERE logical_key=? AND lifecycle_state IN ('PILOT','PUBLISHED')",Integer.class,form.logicalKey()));
        for(var row:(List<Map<String,Object>>)currentRegistry.get("packages")) {
            if(!Set.of("ielts/cambridge-ielts-17/test-2","ielts/cambridge-ielts-4/test-1","ielts/cambridge-ielts-6/test-1","ielts/cambridge-ielts-6/test-3").contains(row.get("testId"))) continue;
            var pkg=MAPPER.readValue(Path.of("src/main/resources/exams/corpus-practice-release/"+row.get("file")).toFile(),ExamContentPackage.class);
            UUID form=catalog.stream().filter(f->f.logicalKey().equals(pkg.form().logicalKey())).findFirst().orElseThrow().id();
            for(var scope:practice.getDiagnostics(form)) {
                assertTrue(scope.ready());
                if(scope.objectiveItemCount()>0) for(String scenario:List.of("ALL_CORRECT","ALL_BLANK","MIXED")) ExamCorpusQualificationPostgresTest.qualify(form,scope.scopeCode(),scenario,scope.questionCount());
                else if(scope.skill()==com.englishcoach.exams.model.ExamTypes.SkillType.SPEAKING) ExamCorpusSpeakingQualification.qualify(form,scope.scopeCode());
                else ExamCorpusPracticeProjectionPostgresTest.writing(form,scope.scopeCode());
            }
        }
        if(Boolean.getBoolean("exams.successor.capture")) Files.writeString(Path.of("../docs/exams-production-verification/20261006/expansion-margin-successor-qualification.json"),MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(receipts),StandardOpenOption.CREATE_NEW);
    }
}
