package com.englishcoach.exams.practice;

import com.englishcoach.exams.content.*;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.media.*;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.service.*;
import org.junit.jupiter.api.*;
import java.nio.file.*;
import java.util.*;
import static com.englishcoach.exams.practice.ExamPracticePostgresTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** Actual fixed batch release and repeat through production storage hashes/import/lifecycle in disposable PostgreSQL. */
class ExamCorpusPracticeReleasePostgresTest {
    static final Path ROOT=Path.of("..");
    static Path temp;
    static LocalExamObjectStorage storage;
    static final List<ExamMediaImportPlan.Plan> MEDIA=new ArrayList<>();
    @BeforeAll @SuppressWarnings("unchecked") static void setup() throws Exception {
        ExamPracticePostgresTest.setUp();
        jdbc.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V73__exams_owner_authorized_production_use.sql")));
        temp=Files.createTempDirectory("exam-qualified-batch-");
        var props=new ExamsProperties(); props.getStorage().getLocal().setBaseDir(temp.toString()); storage=new LocalExamObjectStorage(props);
        Map<String,Object> registry=MAPPER.readValue(ExamCorpusPracticeReleasePostgresTest.class.getResourceAsStream("/exams/corpus-practice-release/registry.json"),Map.class);
        for(var row:(List<Map<String,Object>>)registry.get("packages")) {
            var pkg=MAPPER.readValue(ExamCorpusPracticeReleasePostgresTest.class.getResourceAsStream("/exams/corpus-practice-release/"+row.get("file")),ExamContentPackage.class);
            var media=ExamMediaImportPlan.plan(pkg,ROOT,true); MEDIA.add(media);
            for(var asset:media.entries()) {
                assertTrue(asset.ready(),asset.assetId()+":"+asset.fileStatus());
                byte[] bytes;
                if(asset.sourcePath().contains("::")) {
                    String[] path=asset.sourcePath().split("::",2);
                    try(var zip=new java.util.zip.ZipFile(ROOT.resolve(path[0]).toFile()); var input=zip.getInputStream(zip.getEntry(path[1]))) { bytes=input.readAllBytes(); }
                } else bytes=Files.readAllBytes(ROOT.resolve(asset.sourcePath()));
                storage.putObject(asset.storageObjectKey(),bytes,asset.mimeType());
            }
        }
    }
    @AfterAll static void close() { if(POOL!=null)POOL.close(); if(pg!=null)pg.stop(); }
    @Test void releaseAndRepeatRequireLiveMediaAndReadyScopes() throws Exception {
        var importer=new ExamContentPackageImporter(contentRepository,new ExamContentPackageValidator(MAPPER)); importer.setValidationService(validation);
        var rights=new ExamRightsService(contentRepository,new ExamMediaRepository(named,MAPPER),new ExamsProperties());
        var publication=new ExamPublicationService(contentRepository,rights,null,validation);
        var failingStorage=org.mockito.Mockito.spy(storage);
        int packageCount=MEDIA.size();
        String lastKey=MEDIA.stream().flatMap(m->m.entries().stream()).reduce((a,b)->b).orElseThrow().storageObjectKey();
        org.mockito.Mockito.doAnswer(call -> new java.io.FilterInputStream(storage.getObjectStream(lastKey)) {
            @Override public int read(byte[] buffer,int offset,int length) throws java.io.IOException {
                throw new java.io.IOException("qualification simulated late storage failure");
            }
        }).when(failingStorage).getObjectStream(lastKey);
        var failedTarget=new ExamCorpusPracticeReleaseService(MAPPER,named,importer,publication,practice,failingStorage);
        var proxy=new org.springframework.aop.framework.ProxyFactory(failedTarget);
        proxy.setProxyTargetClass(true);
        proxy.addAdvice(new org.springframework.transaction.interceptor.TransactionInterceptor(
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(named.getJdbcTemplate().getDataSource()),
                new org.springframework.transaction.annotation.AnnotationTransactionAttributeSource()));
        var transactional=(ExamCorpusPracticeReleaseService)proxy.getProxy();
        assertThrows(java.io.IOException.class,()->transactional.releaseQualifiedBatch(1L));
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM exams.project_usage_authorizations WHERE import_basis = 'OWNER_AUTHORIZED_PRODUCTION_USE'",Integer.class),"a late checked failure rolls back earlier imports");
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM exams.audit_events WHERE action = 'CORPUS_QUALIFIED_PRACTICE_ACTIVATED'",Integer.class));
        var service=new ExamCorpusPracticeReleaseService(MAPPER,named,importer,publication,practice,storage);
        proxy.setTarget(service);
        var packageTransactions=(ExamCorpusPracticeReleaseService)proxy.getProxy();
        assertThrows(IllegalArgumentException.class,()->packageTransactions.releaseQualifiedPackage(1L,-1));
        assertThrows(IllegalArgumentException.class,()->packageTransactions.releaseQualifiedPackage(1L,packageCount));
        List<Map<String,Object>> released=new ArrayList<>();
        Map<String,Object> registry=MAPPER.readValue(getClass().getResourceAsStream("/exams/corpus-practice-release/registry.json"),Map.class);
        var rows=(List<Map<String,Object>>)registry.get("packages");
        assertThrows(IllegalArgumentException.class,()->packageTransactions.releaseSubmittedPackage(null,null));
        for(int index=0;index<packageCount;index++) {
            var pkg=MAPPER.readValue(getClass().getResourceAsStream("/exams/corpus-practice-release/"+rows.get(index).get("file")),ExamContentPackage.class);
            var broken=MAPPER.valueToTree(pkg);
            ((com.fasterxml.jackson.databind.node.ObjectNode)broken.get("manifest")).put("contentHash","0".repeat(64));
            var invalid=MAPPER.treeToValue(broken,ExamContentPackage.class);
            assertThrows(IllegalStateException.class,()->packageTransactions.releaseSubmittedPackage(1L,invalid));
            var one=packageTransactions.releaseSubmittedPackage(1L,pkg);
            assertEquals(1,one.size());
            assertEquals(0,one.get(0).get("packageIndex"));
            assertEquals(1,one.get(0).get("packageCount"));
            assertEquals("ALREADY_IMPORTED",packageTransactions.releaseSubmittedPackage(1L,pkg).getFirst().get("operation"));
            var liveCodes=(Set<String>)one.getFirst().get("scopeCodes");
            if(liveCodes.size()>1) {
                var reduced=ExamPracticePackageProjection.build(pkg,true,List.of(),Set.of(liveCodes.iterator().next()),MAPPER,java.time.Instant.now());
                assertThrows(IllegalStateException.class,()->packageTransactions.releaseSubmittedPackage(1L,reduced.pkg()),"accepted scopes must survive a content successor");
            }
            released.addAll(one);
            assertEquals(index+1,jdbc.queryForObject("SELECT COUNT(*) FROM exams.project_usage_authorizations WHERE import_basis = 'OWNER_AUTHORIZED_PRODUCTION_USE'",Integer.class));
        }
        assertEquals(packageCount,released.size());
        assertEquals(packageCount,jdbc.queryForObject("SELECT COUNT(*) FROM exams.project_usage_authorizations WHERE import_basis = 'OWNER_AUTHORIZED_PRODUCTION_USE'",Integer.class));
        int audits=jdbc.queryForObject("SELECT COUNT(*) FROM exams.audit_events WHERE action = 'CORPUS_QUALIFIED_PRACTICE_ACTIVATED'",Integer.class);
        assertEquals(packageCount,audits);
        assertTrue(service.releaseQualifiedBatch(1L).stream().allMatch(r->"ALREADY_IMPORTED".equals(r.get("operation"))));
        assertEquals(audits,jdbc.queryForObject("SELECT COUNT(*) FROM exams.audit_events WHERE action = 'CORPUS_QUALIFIED_PRACTICE_ACTIVATED'",Integer.class));
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM exams.content_reviews",Integer.class));
        assertEquals(0,jdbc.queryForObject("SELECT COUNT(*) FROM exams.form_versions WHERE lifecycle_state = 'PUBLISHED'",Integer.class));
        var asset=MEDIA.stream().flatMap(m->m.entries().stream()).findFirst().orElseThrow();
        storage.putObject(asset.storageObjectKey(),new byte[]{0},asset.mimeType());
        assertThrows(IllegalStateException.class,()->service.releaseQualifiedBatch(1L));
        var submitted=MAPPER.readValue(getClass().getResourceAsStream("/exams/corpus-practice-release/"+rows.getFirst().get("file")),ExamContentPackage.class);
        assertThrows(IllegalStateException.class,()->service.releaseSubmittedPackage(1L,submitted));
        if (Boolean.getBoolean("exams.release.capture")) {
            String prefix=System.getProperty("exams.release.capture-prefix","expansion");
            if(!prefix.matches("[a-z0-9-]+")) throw new IllegalArgumentException("invalid capture prefix");
            Files.writeString(ROOT.resolve("docs/exams-production-verification/20261006/"+prefix+"-production-media-plan.json"),MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(MEDIA),StandardOpenOption.CREATE_NEW);
            Files.writeString(ROOT.resolve("docs/exams-production-verification/20261006/"+prefix+"-fixed-batch-disposable-release.json"),MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(released),StandardOpenOption.CREATE_NEW);
        }
    }
}
