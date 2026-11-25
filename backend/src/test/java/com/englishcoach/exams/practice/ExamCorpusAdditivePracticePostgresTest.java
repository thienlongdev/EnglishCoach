package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.media.*;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.*;
import org.junit.jupiter.api.*;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import static com.englishcoach.exams.practice.ExamPracticePostgresTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** Family-level additive candidates against exact accepted registry rows in disposable PostgreSQL. */
class ExamCorpusAdditivePracticePostgresTest {
    static final Path ROOT=Path.of("..");
    static final String BOOK=System.getProperty("exams.additive.book","ybm-vol-2");
    static final boolean STRUCTURAL_ONLY=Boolean.getBoolean("exams.additive.structural-only");
    static final boolean FULL_SUCCESSOR=Boolean.getBoolean("exams.additive.full-successor");
    static final boolean SOURCE_SUCCESSOR=FULL_SUCCESSOR || Boolean.getBoolean("exams.additive.source-successor");
    static final Path CANDIDATES=ExamCorpusPracticeProjectionPostgresTest.capturePath("exams.additive.candidates",
            ROOT.resolve("imports/exams/staging/phase-b/ybm2-projection-3930"));
    static LocalExamObjectStorage storage;
    static final List<Map<String,Object>> ROWS=new ArrayList<>();
    @BeforeAll static void setup() throws Exception {
        assertTrue(BOOK.matches("[a-z0-9]+(?:-[a-z0-9]+)*"));
        try { ExamPracticePostgresTest.setUp(); }
        catch (org.opentest4j.TestAbortedException e) {
            if(Boolean.getBoolean("exams.additive.capture")) throw new IllegalStateException("ADDITIVE_QUALIFICATION_ENVIRONMENT_UNAVAILABLE",e);
            throw e;
        }
        jdbc.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V73__exams_owner_authorized_production_use.sql")));
        var props=new ExamsProperties(); props.getStorage().getLocal().setBaseDir(Files.createTempDirectory("exam-additive-").toString());
        storage=new LocalExamObjectStorage(props);
        var repository=new ExamMediaRepository(named,MAPPER);
        media=new ExamMediaService(repository,attemptRepository,new ExamRightsService(contentRepository,repository,new ExamsProperties()),storage);
    }
    @AfterAll static void close() throws Exception {
        if(POOL!=null)POOL.close(); if(pg!=null)pg.stop();
        if(Boolean.getBoolean("exams.additive.capture") && !ROWS.isEmpty()) {
            Path report=ExamCorpusPracticeProjectionPostgresTest.capturePath("exams.additive.report",
                    ROOT.resolve("docs/exams-production-verification/20261006/phase-b-additive-qualification.json"));
            Files.writeString(report,MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(Map.of(
                    "productionAccepted",false,"productionWrites",false,"humanApprovalsWritten",0,"book",BOOK,"results",ROWS)),StandardOpenOption.CREATE_NEW);
        }
    }
    @Test @SuppressWarnings("unchecked") void familyAddsScopesWithoutChangingAcceptedSnapshots() throws Exception {
        var importer=new ExamContentPackageImporter(contentRepository,new ExamContentPackageValidator(MAPPER)); importer.setValidationService(validation);
        var state=new ExamImportStateJdbcReader(named,MAPPER); var executor=new ExamImportExecutor(importer,state,MAPPER);
        var rights=new ExamRightsService(contentRepository,new ExamMediaRepository(named,MAPPER),new ExamsProperties());
        var publication=new ExamPublicationService(contentRepository,rights,null,validation);
        Path acceptedIndex=ExamCorpusPracticeProjectionPostgresTest.capturePath("exams.additive.accepted-index",
                ROOT.resolve("docs/exams-production-verification/20261006/phase-b-ybm2-four-only-indexes.json"));
        Map<String,Object> registry=MAPPER.readValue(acceptedIndex.toFile(),Map.class);
        Path acceptedPackages=ExamCorpusPracticeProjectionPostgresTest.capturePath("exams.additive.accepted-packages",
                ROOT.resolve("docs/exams-production-verification/20261006/phase-b-ybm2-accepted-before-additive"));
        Map<String,ExamContentPackage> accepted=new TreeMap<>(); Map<String,Set<String>> acceptedScopeCodes=new HashMap<>(); Map<UUID,String> snapshots=new HashMap<>();
        for(var row:(List<Map<String,Object>>)registry.get("packages")) {
            String testId=String.valueOf(row.get("testId"));
            if(!testId.matches("(toeic|ielts)/[a-z0-9-]+/test-[1-9][0-9]*")) throw new IllegalArgumentException("ADDITIVE_ACCEPTED_IDENTITY_INVALID");
            if(!"all".equals(BOOK) && !testId.split("/")[1].equals(BOOK)) continue;
            String filename=testId.replace("/","__")+".json";
            var pkg=MAPPER.readValue(acceptedPackages.resolve(filename).toFile(),ExamContentPackage.class);
            assertEquals(row.get("packageHash"),pkg.manifest().contentHash());
            assertEquals(row.get("packageHash"),new ExamContentPackageValidator(MAPPER).computeContentHash(pkg));
            Set<String> scopes=new TreeSet<>((List<String>)row.get("scopeCodes"));
            var projection=new ExamPracticePackageProjection.Result(pkg,scopes,Map.of());
            var mediaPlan=verifiedMedia(pkg); var gate=ExamPracticeReleaseReadiness.evaluate(projection,mediaPlan,MAPPER,Instant.now());
            assertTrue(gate.importReady(),gate.blockers().toString());
            var plan=ExamImportPlanner.planPractice(pkg,gate,mediaPlan,List.of(),state,ExamImportPlanner.Target.PRODUCTION);
            var imported=executor.execute(plan,pkg,1L);
            publication.activateQualifiedPractice(imported.importedPackage(),scopes,1L,practice);
            if(!STRUCTURAL_ONLY) {
                UUID id=practice.createPracticeAttempt(LEARNER,new ExamPracticeRecords.CreatePracticeAttemptRequest(imported.result().formId(),scopes.iterator().next(),null)).attemptId();
                snapshots.put(id,jdbc.queryForObject("SELECT manifest_snapshot::text FROM exams.attempts WHERE id=?",String.class,id));
            }
            accepted.put(filename,pkg);
            acceptedScopeCodes.put(filename,scopes);
        }
        assertFalse(accepted.isEmpty(),"no accepted family packages in hash-pinned index");
        int added=0;
        for(var entry:accepted.entrySet()) {
            Path path=CANDIDATES.resolve(entry.getKey()); if(!Files.exists(path)) continue;
            byte[] before=Files.readAllBytes(path);
            var pkg=MAPPER.readValue(before,ExamContentPackage.class);
            assertEquals(entry.getValue().licenses(),pkg.licenses(),"shared licence definitions must remain exact");
            Set<String> scopes=new TreeSet<>((List<String>)((Map<String,Object>)pkg.manifest().metadata().get("practiceProjection")).get("retainedScopes"));
            var combined=new ExamPracticePackageProjection.Result(pkg,scopes,Map.of());
            if (SOURCE_SUCCESSOR && pkg.items().size()<200) {
                Set<String> retainedOld=new TreeSet<>(acceptedScopeCodes.get(entry.getKey()));
                retainedOld.removeAll(scopes);
                if (!retainedOld.isEmpty()) {
                    var predecessorParts=ExamPracticePackageProjection.build(entry.getValue(),true,List.of(),retainedOld,MAPPER,Instant.now());
                    combined=ExamPracticeAdditivePackageBuilder.build(predecessorParts.pkg(),combined,MAPPER);
                    // Preserve source derivations for the retained predecessor audio graph.
                    var merged=(com.fasterxml.jackson.databind.node.ObjectNode)MAPPER.valueToTree(combined.pkg());
                    Set<String> mediaHashes=new HashSet<>();combined.pkg().assets().forEach(a->mediaHashes.add(a.sha256Hash()));
                    Map<String,Object> segments=new TreeMap<>();
                    for(var sourcePackage:List.of(predecessorParts.pkg(),pkg)) {
                        Object value=sourcePackage.manifest().metadata().get("audioSegments");
                        if(value instanceof List<?> list) for(Object segment:list) if(segment instanceof Map<?,?> map) {
                            String sha=String.valueOf(map.get("segmentSha256"));
                            if(mediaHashes.contains(sha)) segments.put(sha,segment);
                        }
                    }
                    ((com.fasterxml.jackson.databind.node.ObjectNode)merged.path("manifest").path("metadata"))
                            .set("audioSegments",MAPPER.valueToTree(segments.values()));
                    var mergedPackage=MAPPER.treeToValue(merged,ExamContentPackage.class);
                    ((com.fasterxml.jackson.databind.node.ObjectNode)merged.path("manifest"))
                            .put("contentHash",new ExamContentPackageValidator(MAPPER).computeContentHash(mergedPackage));
                    combined=new ExamPracticePackageProjection.Result(MAPPER.treeToValue(merged,ExamContentPackage.class),combined.retainedScopes(),combined.excludedScopes());
                    scopes=new TreeSet<>(combined.retainedScopes());
                }
            }
            if (FULL_SUCCESSOR) {
                assertEquals(200,pkg.items().size(),"full source successor requires 200 questions");
                assertEquals(7,scopes.size(),"full source successor requires all Parts");
            } else if (!SOURCE_SUCCESSOR) combined=ExamPracticeAdditivePackageBuilder.build(entry.getValue(),combined,MAPPER);
            var mediaPlan=verifiedMedia(combined.pkg()); var gate=ExamPracticeReleaseReadiness.evaluate(combined,mediaPlan,MAPPER,Instant.now());
            assertTrue(gate.importReady(),gate.blockers().toString());
            var plan=ExamImportPlanner.planPractice(combined.pkg(),gate,mediaPlan,List.of(),state,ExamImportPlanner.Target.PRODUCTION);
            assertNotEquals(ExamImportPlanner.Operation.BLOCKED,plan.operation(),plan.blockers().toString());
            if(plan.operation()==ExamImportPlanner.Operation.ALREADY_IMPORTED) continue;
            ExamImportExecutor.Outcome outcome;
            if (SOURCE_SUCCESSOR) {
                var sourceSuccessor=ExamPackageSuccessorBuilder.build(combined.pkg(),ExamPackageIdentity.of(entry.getValue()),
                        plan.plannedFormVersion(),plan.plannedPackageVersion(),MAPPER).pkg();
                var service=new ExamCorpusPracticeReleaseService(MAPPER,named,importer,publication,practice,storage);
                String retainedOnly=((TreeSet<String>)scopes).last();
                var reduced=ExamPracticePackageProjection.build(combined.pkg(),true,List.of(),Set.of(retainedOnly),MAPPER,Instant.now());
                String retainedPart=retainedOnly.replace("TOEIC_", "");
                if (entry.getValue().parts().size()>1 || entry.getValue().parts().stream().noneMatch(p->p.partCode().endsWith(retainedPart)))
                    assertThrows(IllegalStateException.class,()->service.releaseSubmittedPackage(1L,reduced.pkg()));
                var receipt=service.releaseSubmittedPackage(1L,combined.pkg());
                assertEquals("NEW_VERSION",receipt.getFirst().get("operation"));
                assertEquals("ALREADY_IMPORTED",service.releaseSubmittedPackage(1L,combined.pkg()).getFirst().get("operation"));
                var imported=importer.findImport(sourceSuccessor.manifest().packageId(),sourceSuccessor.manifest().packageVersion()).orElseThrow();
                outcome=new ExamImportExecutor.Outcome(plan.operation(),new ExamContentPackage.ImportResult(
                        imported.packageId(),imported.packageVersion(),imported.contentHash(),imported.formId(),
                        ExamContentPackage.ImportStatus.IMPORTED,false,List.of()),sourceSuccessor);
            } else outcome=executor.execute(plan,combined.pkg(),1L);
            publication.activateQualifiedPractice(outcome.importedPackage(),combined.retainedScopes(),1L,practice);
            if (combined.pkg().items().size()==200) assertTrue(validation.revalidate(outcome.result().formId(),
                    com.englishcoach.exams.validation.ExamContentValidationService.Trigger.ADMIN).fullSimulationEligible(),
                    "full source successor must pass authoritative full simulation validation");
            for(var scope:practice.getDiagnostics(outcome.result().formId())) {
                assertTrue(scope.ready());
                if(STRUCTURAL_ONLY) continue;
                assertTrue(scope.objectiveItemCount()>0);
                for(String scenario:List.of("ALL_CORRECT","ALL_BLANK","MIXED"))
                    ExamCorpusQualificationPostgresTest.qualify(outcome.result().formId(),scope.scopeCode(),scenario,scope.questionCount(),scope.skill()==com.englishcoach.exams.model.ExamTypes.SkillType.LISTENING);
            }
            assertArrayEquals(before,Files.readAllBytes(path));
            assertEquals(ExamImportPlanner.Operation.ALREADY_IMPORTED,ExamImportPlanner.planPractice(combined.pkg(),gate,
                    mediaPlan,List.of(),state,ExamImportPlanner.Target.PRODUCTION).operation());
            ROWS.add(Map.of("file",entry.getKey(),"operation",plan.operation().name(),"scopeCodes",combined.retainedScopes(),
                    "packageHash",combined.pkg().manifest().contentHash(),"expectedImportedPackageHash",outcome.importedPackage().manifest().contentHash(),
                    "formVersion",outcome.importedPackage().form().version(),
                    "checks",STRUCTURAL_ONLY ? List.of("STRUCTURAL_IMPORT_READINESS","MEDIA_BYTES_VERIFIED",FULL_SUCCESSOR ? "IMMUTABLE_FULL_SUCCESSOR_IMPORT" : "ACCEPTED_GRAPH_RETENTION","REPEAT_IDEMPOTENCY") : List.of("CORRECT_BLANK_MIXED","SAVE_SUBMIT_RESULT_RELOAD_REVIEW","MEDIA_GRANT_RESOLUTION","ACCEPTED_GRAPH_RETENTION","HISTORICAL_SNAPSHOT_RETENTION","REPEAT_IDEMPOTENCY")));
            if(Boolean.getBoolean("exams.additive.capture")) {
                Path output=ExamCorpusPracticeProjectionPostgresTest.capturePath("exams.additive.output",ROOT.resolve("imports/exams/staging/phase-b/additive-candidates"));
                Files.createDirectories(output);
                Files.writeString(output.resolve(entry.getKey()),MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(combined.pkg()),StandardOpenOption.CREATE_NEW);
                Path imported=output.resolve("expected-imported"); Files.createDirectories(imported);
                Files.writeString(imported.resolve(entry.getKey()),MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(outcome.importedPackage()),StandardOpenOption.CREATE_NEW);
            }
            added++;
        }
        assertTrue(added>0,"no additive family scope qualified");
        for(var entry:snapshots.entrySet()) assertEquals(entry.getValue(),jdbc.queryForObject("SELECT manifest_snapshot::text FROM exams.attempts WHERE id=?",String.class,entry.getKey()));
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM exams.content_reviews",Integer.class));
    }
    static ExamMediaImportPlan.Plan verifiedMedia(ExamContentPackage pkg) throws Exception {
        Map<String,ExamMediaImportPlan.CropQa> crops=new HashMap<>();
        String qaPath=System.getProperty("exams.additive.media-qa");
        if (qaPath != null) {
            var qa=MAPPER.readTree(ExamCorpusPracticeProjectionPostgresTest.capturePath("exams.additive.media-qa",ROOT).toFile());
            for (var family:qa.path("packages")) for (var crop:family.path("cropUnits")) {
                crops.put(crop.path("cropSha256").asText(),new ExamMediaImportPlan.CropQa(
                        crop.path("technical").asText(),crop.path("humanApproved").asBoolean(),
                        crop.path("ownerTechnicalApproved").asBoolean()));
            }
        }
        var plan=ExamMediaImportPlan.plan(pkg,ROOT,true,crops);
        for(var entry:plan.entries()) {
            assertTrue(entry.ready(),entry.fileStatus().toString());
            byte[] bytes;
            if(entry.sourcePath().contains("::")) {
                String[] parts=entry.sourcePath().split("::",2);
                try(var zip=new java.util.zip.ZipFile(ROOT.resolve(parts[0]).toFile());var input=zip.getInputStream(zip.getEntry(parts[1]))) { bytes=input.readAllBytes(); }
            } else bytes=Files.readAllBytes(ROOT.resolve(entry.sourcePath()));
            storage.putObject(entry.storageObjectKey(),bytes,entry.mimeType());
        }
        return plan;
    }
}
