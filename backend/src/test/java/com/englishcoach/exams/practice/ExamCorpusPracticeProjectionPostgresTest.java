package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import org.junit.jupiter.api.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import static com.englishcoach.exams.practice.ExamPracticePostgresTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** Whole indexed corpus through scoped QA, byte-verified media, canonical production-basis planner/importer,
 * and objective/Writing terminal lifecycles in disposable PostgreSQL. Production browser acceptance remains required.
 */
class ExamCorpusPracticeProjectionPostgresTest {
    static final Path ROOT = Path.of("..");
    static final Path STAGING = capturePath("exams.projection.staging", ROOT.resolve("imports/exams/staging"));
    static final Path OUTPUT = capturePath("exams.projection.output", STAGING.resolve("release-candidates/20261006"));
    static final Path REPORT = capturePath("exams.projection.report", ROOT.resolve("docs/exams-production-verification/20261006/expansion-practice-projection-qualification.json"));
    static final List<Map<String,Object>> ROWS = new ArrayList<>();
    static final boolean CAPTURE = Boolean.getBoolean("exams.projection.capture");
    static final String BOOK_FILTER = System.getProperty("exams.projection.book");
    static final boolean STRUCTURAL_ONLY = Boolean.getBoolean("exams.projection.structural-only");
    @BeforeAll static void setup() throws Exception {
        if (BOOK_FILTER != null) assertTrue(BOOK_FILTER.matches("[a-z0-9]+(?:-[a-z0-9]+)*"), "invalid book selector");
        ExamPracticePostgresTest.setUp();
        jdbc.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V73__exams_owner_authorized_production_use.sql")));
        if (CAPTURE) Files.createDirectories(OUTPUT);
    }
    @AfterAll static void close() throws Exception {
        if (POOL != null) POOL.close(); if (pg != null) pg.stop();
        if (CAPTURE) Files.writeString(REPORT,
                MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(Map.of("productionAccepted",false,"productionWrites",false,"humanApprovalsWritten",0,
                        "qualificationMode",STRUCTURAL_ONLY ? "AUTOMATED_STRUCTURE_IMPORT_READINESS" : "DISPOSABLE_ATTEMPT_LIFECYCLE", "results",ROWS)), StandardOpenOption.CREATE_NEW);
    }
    static Path capturePath(String key, Path fallback) {
        String configured = System.getProperty(key);
        Path path = configured == null ? fallback : ROOT.resolve(configured);
        path = path.toAbsolutePath().normalize();
        if (!path.startsWith(ROOT.toAbsolutePath().normalize())) throw new IllegalArgumentException("capture path escapes workspace");
        return path;
    }
    @Test @SuppressWarnings("unchecked") void qualifyEveryIndexedPracticeProjection() throws Exception {
        Map<String,Object> runs=MAPPER.readValue(STAGING.resolve("cache/runs.json").toFile(),Map.class);
        Map<String,Object> qaRoot=(Map<String,Object>)MAPPER.readValue(STAGING.resolve("reports/qa_release_review.json").toFile(),Map.class).get("packages");
        var importer=new ExamContentPackageImporter(contentRepository,new ExamContentPackageValidator(MAPPER)); importer.setValidationService(validation);
        var state=new ExamImportStateJdbcReader(named,MAPPER); var executor=new ExamImportExecutor(importer,state,MAPPER);
        var releaseProps=new com.englishcoach.exams.config.ExamsProperties();
        releaseProps.getStorage().getLocal().setBaseDir(Files.createTempDirectory("exam-projection-release-").toString());
        var releaseStorage=new com.englishcoach.exams.media.LocalExamObjectStorage(releaseProps);
        var releasePublication=new com.englishcoach.exams.service.ExamPublicationService(contentRepository,
                new com.englishcoach.exams.service.ExamRightsService(contentRepository,
                        new com.englishcoach.exams.repository.ExamMediaRepository(named,MAPPER),releaseProps),null,validation);
        int qualified=0;
        for (String testId:new TreeSet<>(runs.keySet())) {
            String[] id=testId.split("/");
            if (BOOK_FILTER != null && !BOOK_FILTER.equals(id[1])) continue;
            Map<?,?> extraction=MAPPER.readValue(STAGING.resolve("reports/extraction/"+id[0]+"/"+id[1]+"__"+id[2]+".json").toFile(),Map.class);
            Map<?,?> ref=(Map<?,?>)extraction.get("package");
            if(ref.get("path")==null) { ROWS.add(Map.of("testId",testId,"state","EXTRACTION_RECOVERY_REQUIRED")); continue; }
            var source=MAPPER.readValue(ROOT.resolve(String.valueOf(ref.get("path"))).toFile(),ExamContentPackage.class);
            Map<String,Object> qa=(Map<String,Object>)qaRoot.getOrDefault(testId,Map.of());
            List<Map<String,Object>> entries=(List<Map<String,Object>>)qa.getOrDefault("entries",List.of());
            Map<String,ExamMediaImportPlan.CropQa> crops=new HashMap<>();
            ((Map<String,Map<String,Object>>)qa.getOrDefault("cropUnits",Map.of())).values().forEach(c->crops.put(String.valueOf(c.get("cropSha256")),new ExamMediaImportPlan.CropQa(String.valueOf(c.get("technical")),Boolean.TRUE.equals(c.get("humanApproved")),Boolean.TRUE.equals(c.get("ownerTechnicalApproved")))));
            var tree=com.englishcoach.exams.validation.ExamContentTree.fromPackage(source,MAPPER);
            var report=com.englishcoach.exams.validation.ExamFormValidator.validate(tree,MAPPER,Instant.now());
            var scopes=ExamPracticeReadiness.evaluate(tree,report,ExamRunnerCapabilities.CURRENT,new ExamPracticeReadiness.FormFacts(true,true),MAPPER);
            var scopedQa=ExamScopedQaReadiness.evaluate(source,tree,scopes,qaRoot.containsKey(testId),entries,MAPPER);
            Set<String> selected=new TreeSet<>(); Map<String,List<String>> excluded=new TreeMap<>();
            for(var scope:scopes) {
                String code=scope.scope().scopeCode();
                try {
                    var single=ExamPracticePackageProjection.build(source,qaRoot.containsKey(testId),entries,Set.of(code),MAPPER,Instant.now());
                    if (scope.scope().skill()==com.englishcoach.exams.model.ExamTypes.SkillType.SPEAKING
                            && single.pkg().items().stream().anyMatch(i -> !"PINNED_CORPUS_SOURCE".equals(i.optionDefinitions().get("speakingPromptBasis")))) {
                        excluded.put(code,List.of("SOURCE_PROMPT_RUNTIME_NOT_QUALIFIED"));
                        continue;
                    }
                    var media=ExamMediaImportPlan.plan(single.pkg(),ROOT,true,crops);
                    var gate=ExamPracticeReleaseReadiness.evaluate(single,media,MAPPER,Instant.now());
                    if(gate.importReady()) selected.add(code); else excluded.put(code,gate.blockers());
                } catch(IllegalArgumentException e) {
                    Set<String> reasons=new TreeSet<>(scope.reasonCodes());
                    reasons.addAll(scopedQa.scopes().get(code).reasonCodes());
                    if(reasons.isEmpty()) reasons.add(e.getMessage());
                    excluded.put(code,List.copyOf(reasons));
                }
            }
            if(selected.isEmpty()) { ROWS.add(Map.of("testId",testId,"state","SCOPED_RECOVERY_REQUIRED","excludedScopes",excluded)); continue; }
            // A 200-item intermediate graph can still contain an invalid Part.
            // Project every independently qualified Part; a seven-Part projection
            // keeps all 200 items and must pass full-simulation validation below.
            var projection=ExamPracticePackageProjection.build(source,true,entries,selected,MAPPER,Instant.now());
            var media=ExamMediaImportPlan.plan(projection.pkg(),ROOT,true,crops);
            var gate=ExamPracticeReleaseReadiness.evaluate(projection,media,MAPPER,Instant.now());
            assertTrue(gate.importReady(),testId+":"+gate.blockers());
            var plan=ExamImportPlanner.planPractice(projection.pkg(),gate,media,List.of(),state,ExamImportPlanner.Target.PRODUCTION);
            assertNotEquals(ExamImportPlanner.Operation.BLOCKED,plan.operation(),testId+":"+plan.blockers());
            var imported=executor.execute(plan,projection.pkg(),1L);
            UUID form=imported.result().formId();
            if (STRUCTURAL_ONLY) {
                for (var asset:media.entries()) {
                    byte[] bytes;
                    if(asset.sourcePath().contains("::")) {
                        String[] sourcePath=asset.sourcePath().split("::",2);
                        try(var zip=new java.util.zip.ZipFile(ROOT.resolve(sourcePath[0]).toFile());
                            var input=zip.getInputStream(zip.getEntry(sourcePath[1]))) {bytes=input.readAllBytes();}
                    } else bytes=Files.readAllBytes(ROOT.resolve(asset.sourcePath()));
                    releaseStorage.putObject(asset.storageObjectKey(),bytes,asset.mimeType());
                }
                releasePublication.activateQualifiedPractice(imported.importedPackage(),selected,1L,practice);
                var releaseService=new ExamCorpusPracticeReleaseService(MAPPER,named,importer,releasePublication,practice,releaseStorage);
                assertEquals("ALREADY_IMPORTED",releaseService.releaseSubmittedPackage(1L,projection.pkg()).getFirst().get("operation"));
            }
            contentRepository.updateFormLifecycle(form,LifecycleState.PILOT,null,null); validation.invalidate(form);
            for(var scope:practice.getDiagnostics(form)) {
                assertTrue(scope.ready(),testId+":"+scope.reasonCodes());
                if (STRUCTURAL_ONLY) continue;
                if(scope.objectiveItemCount()>0) for(String scenario:List.of("ALL_CORRECT","ALL_BLANK","MIXED")) ExamCorpusQualificationPostgresTest.qualify(form,scope.scopeCode(),scenario,scope.questionCount());
                else if(scope.skill()==com.englishcoach.exams.model.ExamTypes.SkillType.SPEAKING)
                    ExamCorpusSpeakingQualification.qualify(form,scope.scopeCode());
                else writing(form,scope.scopeCode());
            }
            var file=OUTPUT.resolve(id[0]+"__"+id[1]+"__"+id[2]+".json");
            if (CAPTURE) Files.writeString(file,MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(projection.pkg()),StandardOpenOption.CREATE_NEW);
            ROWS.add(Map.of("testId",testId,"state","DISPOSABLE_PRODUCTION_BASIS_PIPELINE_PASS","candidateFile",ROOT.toAbsolutePath().normalize().relativize(file).toString().replace('\\','/'),
                    "packageHash",projection.pkg().manifest().contentHash(),"scopeCodes",selected,"excludedScopes",excluded,"plan",plan.asMap())); qualified++;
        }
        assertTrue(qualified>0);
    }
    static void writing(UUID form,String scope) throws Exception {
        UUID id=practice.createPracticeAttempt(LEARNER,new ExamPracticeRecords.CreatePracticeAttemptRequest(form,scope,null)).attemptId(); start(id,LEARNER);
        String placement=placements(id,LEARNER).values().iterator().next(); String text="synthetic qualification response ".repeat(40).trim();
        save(id,LEARNER,Map.of(placement,text)); UUID submission=submit(id,LEARNER);
        var result=practice.getResult(LEARNER,id); assertEquals("SUBMITTED",result.completionStatus()); assertEquals("RESPONSE_ONLY",result.scoringMode());
        assertFalse(result.standardizedScoreAvailable()); assertEquals(120,result.wordCount());
        assertEquals(result,practice.getResult(LEARNER,id)); assertEquals(text,practice.getReview(LEARNER,id).groups().getFirst().items().getFirst().learnerAnswer());
        assertTrue(scoringRepository.findComponentsByArtifactId(scoringRepository.findLatestArtifactBySubmissionId(submission).orElseThrow().id()).isEmpty());
    }
}
